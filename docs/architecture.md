# Architecture

This document describes what AutoLoop actually does, in the order control
flows, and names who owns authority at each step. Every claim here maps to a
module you can read.

## The flow

```
   task card
       │
       ▼
┌──────────────────┐
│ 1. CLASSIFY      │  deterministic scoring → size, risk, profile
│    classify.mjs  │  (no model involved)
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 2. ADMIT         │  → frozen admission record:
│ admission-       │     capabilities, mutation scope, budget envelope,
│ record.mjs       │     isolation/durability policy, review requirement
└────────┬─────────┘     digest-bound, exclusive-create, immutable
         ▼
┌──────────────────┐
│ 3. PLAN          │  decompose into a DAG of phases (optional intelligence:
│  decompose /     │  when the optional layer is absent the decomposition
│  orchestration   │  stage fails CLOSED with DECOMPOSITION_UNAVAILABLE)
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 4. PROJECT       │  admission → concrete, enforceable policy:
│ policy-          │    · tool selection (which tools this node may call)
│ projection.mjs   │    · mutation scope (which paths are writable)
│                  │    · budget slice, isolation mode, reviewer identity
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 5. EXECUTE       │  admitted graph runner:
│ durable-graph /  │    sandbox container (network off, caps dropped)
│ subagent-graph / │    → agent runtime (`pi`) with a pinned identity
│ colima-runner    │    → harness observes the real filesystem/git
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 6. VERIFY +      │  harness-owned facts (changed paths, digests,
│    REVIEW        │  test results) + an independent reviewer role that
│ lifecycle-       │  holds NO mutation authority
│ runner.mjs       │
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 7. CLOSE OUT     │  evidence bundle, closeout state, review job,
│  governance      │  semantic-drift gate, pass oracle
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 8. PROMOTE       │  commit gate: only after PASS, with every gate's
│  promotion /     │  digest re-verified against live state
│  commit gates    │
└────────┬─────────┘
         ▼
   PASS / REPAIR / HOLD   (+ durable evidence for every step)
```

Alongside this, but never inside it:

```
   every eligible run ──► attribution feed ──► performance memory
                                                    │
   policy (operator-issued) ──► evolution loop ◄────┘
        trigger → candidate → fitness → review → promotion → canary → rollback
```

The evolution loop observes the flow above. It cannot grant itself authority
inside it.

## Authority ownership

The central design rule: **each decision has exactly one owner, and authority
is a durable artifact rather than a convention.**

| Concern | Owner | Where | Can the agent influence it? |
|---|---|---|---|
| Size / risk classification | deterministic scorer | `src/admission/classify.mjs` | No — inputs are evidence scores, and the scorer has no model call |
| Capability set | admission record | `src/admission/admission-record.mjs` | No |
| Mutation scope | admission record | `src/admission/admission-record.mjs` | No |
| Scope path semantics | canonicalization seam | `src/c2d/mutation-scope.mjs` | No — projection and enforcement resolve through the same functions, so a declared boundary is never "authorized" where the gate would refuse it |
| Symlink write containment | git-independent filesystem audit | `src/c2d/write-containment.mjs` | No — the worktree is inspected with `lstat`/`readlink`/`realpath` before and after the mutation; a write through a pre-existing symlink produces no git changed path and would otherwise be invisible |
| Tool selection | projection from admission | `src/admission/policy-projection.mjs` | No — caller hooks, prompts and raw tool policy have zero influence |
| Budget envelope | admission → budget ledger | `src/budget/envelope.mjs` | No — reserved before execution, metered during |
| Runtime identity | pinned contract | `src/admission/policy-projection.mjs` | No — drift is a fail-closed HOLD |
| Changed paths / digests | harness re-observation | `src/v2/durable-graph.mjs`, evidence store | No — read from the real tree and git objects |
| Test results | harness-run command | lifecycle runner | No — a claimed PASS without harness evidence is rejected |
| Review verdict | reviewer role | `src/control-plane/coordinator.mjs` | No — role separation, self-approval structurally refused |
| Promotion | policy + fitness + review + drift gates | `src/evolution/promotion.mjs` | No |
| Commit | commit gate | `scripts/gov-commit-checkpoint.mjs` | No |

### Why the projection is a single seam

`projectToolSelection` is the only place that turns an admission record into
concrete per-node policy. Because there is exactly one such function,
"the agent asked for more tools" has nowhere to land: the request is simply not
an input. The same applies to mutation scope — every write path is checked
against the frozen scope, re-verified against the real tree, not against a
cached list.

## Execution: three runners, one contract

All three production runners are wrapped by the same gate
(`runAdmittedGraph` in `src/admission/admission-gate.mjs`), which refuses to
start without a valid admission and allocation:

| Runner | Module | Use |
|---|---|---|
| Durable graph | `src/v2/durable-graph.mjs` | the default: checkpoint + journal + resume |
| Subagent graph | `src/subagent/subagent-graph-runner.mjs` | fan-out/fan-in with per-node roles |
| Colima graph | `src/runtime/colima-runtime.mjs` + graph runner | container-isolated execution |

A runner never mints authority. It consumes the projection and reports
observed facts.

## Isolation

Sandbox execution uses a Colima-hosted Docker VM. The runtime adapter enforces:

- an explicitly pinned socket per Colima profile — never the ambient
  `DOCKER_HOST` or the shell's default context;
- an explicit mount allowlist — no whole-`$HOME` auto-mount;
- task containers with `network none`, `--cap-drop ALL`,
  `--security-opt no-new-privileges`, and pids/memory/cpu limits;
- the runtime socket is never mounted into a task container;
- a single-flight lock per profile, so two operations can never interleave
  stop/start underneath each other (a second one fails with
  `COLIMA_PROFILE_BUSY`);
- an optional storage gate: with `AUTOLOOP_COLIMA_MOUNT` +
  `AUTOLOOP_COLIMA_MOUNT_UUID` configured, the runtime home must sit on that
  volume with a matching UUID and no shadow mount, or nothing runs.

Without Colima, execution falls back to host-process isolation, which is
**weaker**. Do not treat it as a security boundary.

## Durable state

There is no external workflow server. Durability is in-process plus
filesystem:

- an **append-only journal** per execution, chained by digest — a tampered or
  reordered row fails validation on read;
- **checkpoints** published atomically, each digest-bound to the journal head;
- **evidence artifacts** written exclusively-create, secret-scanned and
  size-bounded;
- **resume** that re-derives state and re-verifies every artifact digest.
  Mismatch ⇒ named HOLD, never a silent proceed.

This is local-filesystem durability: it survives process crash and machine
restart, not disk loss or multi-machine splits. Details:
[durable-execution.md](durable-execution.md).

## Review and gates

- **Reviewer separation is structural.** The reviewer is a distinct role with a
  tool policy of no-tools; a reviewer reaching the tool selector is treated as a
  bypass attempt, not a request.
- **Harness-owned facts.** Evidence bundles carry machine-collected facts
  (paths, digests, test runs) alongside the model's narrative. The narrative is
  labelled advisory.
- **Commit gate.** `commit_allowed` is derived from the admission; the commit
  path re-verifies that the tree, the evidence digest and the review verdict
  still agree with what was reviewed.
- **Semantic-drift gate.** A canonical-digest comparison catches a change that
  is syntactically valid but semantically different from what was reviewed.

Details: [governance.md](governance.md).

## Telemetry

Telemetry is a separate namespace from evidence, and the separation is a fence,
not tidiness: everything under telemetry is observability, everything under
evidence is authority. Retention classes (R0–R4) assign each persistent surface
exactly one class, and GC-protected classes may never live in the telemetry
namespace — the resolver refuses that configuration outright.

Telemetry is never a task authority: a resolution failure surfaces as
`TELEMETRY_UNAVAILABLE` and cannot change any task semantic.

Details: [telemetry-and-operator.md](telemetry-and-operator.md).

## Rollover and continuity

A long run can exceed one agent session. Rollover hands the work to a successor
session with:

- an explicit generation identity, so a stale session can never act as current;
- a durable handover record — the successor reconstructs state from artifacts,
  not from the predecessor's message history;
- fail-closed behaviour when the handover is incomplete
  (`CROSS_SESSION_ROLLOVER_IN_PROGRESS_*`).

Rollover is `EXPERIMENTAL`: the identity and fencing model is tested, but it is
the newest part of the system.

## Evolution and learning boundaries

Both live *beside* the execution path:

- the **attribution feed** writes secret-free performance observations for
  every eligible run — it mints no authority, and nothing consumes its output
  without a policy authorisation and a promotion gate;
- the **evolution loop** can only touch strategy dimensions the operator
  declared in an issued policy, and can only touch LOW-risk ones autonomously;
- **forbidden paths** (`src/governance/**`, `src/admission/**`,
  `src/evolution/**`, `.git/**`, and the governance record root) are checked at
  authorisation time and are not overridable by a candidate.

Details: [autonomous-evolution.md](autonomous-evolution.md),
[cross-agent-learning.md](cross-agent-learning.md).

## Module map

```
src/
  adapter/        agent-runtime adapters (Pi RPC, scripted) + the adapter contract
  admission/      classification, admission record, policy projection, gates
  budget/         envelope projection, metering
  c2d/            atomic state machine, locks, mutation scope
  control-plane/  task coordination, reviewer derivation, sequential execution
  evidence/       evidence store, secret scanning, digests
  evolution/      policy, triggers, candidates, fitness, promotion, operator view
  governance/     closeout state, review bundle/job, pass oracle, drift gate
  learning/       transfer metrics, incidents, lifecycle
  memory/         canonical JSON, JSONL journal, local store, retrieval
  orchestration/  decomposition pipeline, structural/semantic validators
  runtime/        Colima adapter, profile lock
  shared/         path resolution (the single configuration seam)
  subagent/       subagent contract, graph runner, role adapters
  prompts/        prompt assembly for role phases
  rollover/       cross-session handover, quarantine validation
  schema/         JSON schemas for the artifact contracts
  sop/            standard-operating-procedure bindings
  telemetry/      event store, location, retention/GC, operator report
  v2/             durable graph, execution orchestrator, phase bridge
scripts/          operator + governance CLIs (public surface)
test/             host suite + fixtures
examples/         minimal and subagent walkthroughs
```
