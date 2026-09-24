# AutoLoop

**An agent governance harness for spec-driven development.** AutoLoop turns a
task card into an *admitted, bounded, evidenced* agent execution: it decides
what may be touched, runs the work in an isolated sandbox through an agent
runtime (Pi today), independently reviews the result, and only then allows a
commit — with a durable record for every step.

Apache-2.0 licensed. See [LICENSE](LICENSE), [NOTICE](NOTICE), and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

> **Status: pre-1.0, best-effort community project.** No production support,
> no SLA, no provider certification. See
> [Project status and limitations](#project-status-and-limitations).

---

## What AutoLoop is

Most agent runners execute a prompt and report the model's own summary of what
it did. That is fine for a script and insufficient for anything you have to
audit. AutoLoop's position is that the *harness* — not the model — owns the
authority, the limits, and the evidence.

Concretely, three design principles distinguish it from a prompt loop or a
generic agent runner:

1. **Admission precedes execution.** A task is first reduced to a frozen
   *admission record*: a risk classification, a capability set, a mutation
   scope, a budget envelope, a durability and isolation policy, and a
   review requirement. The agent can never widen any of it. Every downstream
   projection — which tools are selectable, which paths are writable, how many
   repair rounds are allowed — is *derived* from that one record, so there is
   no second place where authority could be minted.
2. **The harness observes, the model does not self-report.** Changed paths,
   file digests, test results, token usage, and the diff itself are collected
   by the harness from the real filesystem and git object store. Model-authored
   summaries are advisory and never evidentiary.
3. **Authority is a durable artifact, not a convention.** Every gate
   (admission, budget, review, promotion, commit) writes a digest-bound,
   exclusive-create record. Resuming after a crash re-derives state from those
   records and the append-only journal, and refuses to proceed when they
   disagree.

### How this differs from a script loop

| | Script/agent loop | AutoLoop |
|---|---|---|
| What the agent may touch | whatever it decides | frozen admission scope, enforced before the executor starts |
| Success signal | process exit code, model summary | harness-collected facts + an independent reviewer verdict |
| Crash mid-run | rerun from the top (or lose the work) | durable checkpoint + journal; resume or fail closed with a named HOLD code |
| Isolation | the host shell | sandbox container by default, network off, capabilities dropped |
| Cost control | hope | budget envelope reserved before execution, metered during |
| Review | the same agent that did the work | separate reviewer role that never holds mutation authority |
| Learning | none | bounded, evidence-gated strategy adaptation with a kill switch |

---

## Current capabilities

Every row states the implementation status honestly. `STABLE` means it is
exercised by the host test suite and is the intended production path.
`CONDITIONAL` means it works but requires external infrastructure or explicit
opt-in configuration. `EXPERIMENTAL` means it exists and is tested but its
interfaces may change. `NOT_SUPPORTED` means it is deliberately absent — do not
expect it.

| Capability | Status | Notes |
|---|---|---|
| Task classification + admission record | STABLE | deterministic risk scoring → frozen admission artifact |
| Admitted agent execution (Pi runtime) | CONDITIONAL | requires a `pi` installation and provider credentials |
| Tool selection binding | STABLE | selection is derived from admission; drift from the pinned runtime identity fails closed |
| Mutation scope enforcement | STABLE | path allow/forbid patterns, re-verified against the real tree |
| Sandboxed execution (Colima + Docker) | CONDITIONAL | requires Colima/Docker; network-off containers, dropped capabilities |
| Durable execution (checkpoint + journal) | STABLE | in-process durable engine; no external workflow server required |
| Crash recovery / resume | STABLE | resume re-validates every artifact digest; mismatch ⇒ HOLD |
| Subagent graph (fan-out / fan-in) | STABLE | writer/reviewer/verifier roles, per-node authority |
| Context rollover / session continuity | EXPERIMENTAL | cross-session handover with generation identity |
| Evidence bundles + provenance | STABLE | digest-bound, secret-scanned, size-bounded artifacts |
| Telemetry + operator inspection | STABLE | append-only stream, retention classes, read-only operator reports |
| Independent review gate | STABLE | reviewer holds no mutation authority; self-approval structurally refused |
| Governance / promotion gates | STABLE | pass-oracle, closeout, semantic-drift and commit gates |
| Autonomous evolution loop | EXPERIMENTAL | evidence → trigger → candidate → fitness → review → promotion → canary |
| Adaptive model routing evolution | EXPERIMENTAL | LOW-risk only, autonomous within policy |
| Retry/repair strategy evolution | EXPERIMENTAL | LOW-risk only, autonomous within policy |
| Prompt evolution | EXPERIMENTAL | **MEDIUM risk — operator promotion required, never autonomous** |
| Cross-agent learning / strategy transfer | EXPERIMENTAL | performance memory keyed by task class × strategy dimension |
| Canary + rollback | EXPERIMENTAL | promotion is reversible; rollback restores the prior generation |
| Circuit breaker + kill switch | STABLE | suspends new evolution cycles; normal operation and telemetry are untouched |
| Self-modification of governance/admission code | NOT_SUPPORTED | structurally forbidden paths; HIGH-risk class denied by construction |
| Multi-tenant / shared-server operation | NOT_SUPPORTED | single-operator, single-machine design |
| Windows / Linux host support | NOT_SUPPORTED | macOS host + Colima VM is the only exercised platform |

### Risk boundaries (do not misread this)

AutoLoop's autonomous path is **not** unrestricted self-modification:

- **LOW risk** — the autonomous loop may propose, validate, review, promote and
  roll back on its own, but only inside a policy that an operator issued in
  advance, and only for the declared strategy dimensions.
- **MEDIUM risk** — requires an operator promotion step. Prompt evolution is
  MEDIUM.
- **HIGH risk** — refused structurally. Credentials, secret handling, security,
  governance and admission/promotion authority, destructive migration, and
  irreversible data operations can never be self-modified; the forbidden path
  patterns are checked at authorisation time and are not overridable by a
  candidate.

---

## Requirements

| Requirement | Version / notes |
|---|---|
| Node.js | **>= 24** (uses `node:sqlite`, `node:test`) — tested on Node 26 |
| npm | >= 10 (any version that writes lockfile v3) |
| git | required — the harness reads the object store and computes baselines |
| Operating system | macOS is the only exercised host (the sandbox integration targets Colima's Lima VM) |
| Agent runtime | optional for the host test suite; **required** to execute a real task (see [Agent and provider integration](#agent-and-provider-integration)) |
| Sandbox runtime | optional; **required** for container-isolated execution (Colima + Docker) |
| Provider credentials | optional; **required** only when contacting a model provider |

Nothing above is installed for you. AutoLoop orchestrates tools you already
have; it does not bundle an agent, a container runtime, or a model.

**AutoLoop is not published to npm.** The `autoloop` name on the npm registry
belongs to an unrelated package, and this repository does not publish under it:
`package.json` sets `"private": true` deliberately. Install AutoLoop by cloning
this repository — that is the only supported distribution channel today.

---

## Quick start

```bash
# 1. Clone
git clone https://github.com/xonogesrs/autoloop.git
cd autoloop

# 2. Install the single runtime dependency
npm install

# 3. Sanity-check the checkout (syntax + host test suite)
npm run check
npm test

# 4. See the operator surface
node scripts/autoloop-operator.mjs --help
```

`npm test` runs the host-only suite: every suite that needs nothing beyond
Node and this checkout. Suites requiring a sandbox or a real agent runtime are
listed and excluded, never silently skipped:
```bash
node test/run-suite.mjs --list   # the exact file list, and what each exclusion needs
```


```bash
node test/run-suite.mjs --list          # see exactly what runs and what is excluded
COLIMA_HOME=/path/to/colima npm run test:colima   # sandbox suites
```

### Inspect a result

The operator view is read-only and safe against unknown, partial or
telemetry-disabled runs:

```bash
node scripts/autoloop-operator.mjs --run <graphRunId>          # human view
node scripts/autoloop-operator.mjs --run <graphRunId> --json   # machine view
```

It reports status, phases, rollover transitions, provider usage and
diagnostics, and performs zero writes.

---

## Minimal example

The smallest complete AutoLoop task: classify → admit → execute → review →
evidence. This runs entirely on the host with a scripted adapter, so it needs
no provider, no `pi`, and no container.

```bash
node examples/minimal/run.mjs
```

It prints the admission decision, the enforced scope, the harness-collected
evidence, and the reviewer verdict. Read
[examples/minimal/README.md](examples/minimal/README.md) for the annotated
walkthrough, then [docs/getting-started.md](docs/getting-started.md) for the
same flow against a real agent.

---

## Multi-agent example

A parent task that decomposes into a fan-out of writer subagents with an
independent reviewer and a join, demonstrating what AutoLoop is actually for:
work that must be split, bounded per node, and verified as a whole.

```bash
node examples/subagent/run.mjs
```

See [examples/subagent/README.md](examples/subagent/README.md).

---

## Autonomous evolution

AutoLoop can improve its own *operating strategy* — never its authority — when
an operator has pre-authorised it. The loop is:

```
evidence  →  trigger  →  candidate  →  fitness  →  review  →  promotion  →  canary  →  accept | rollback
```

- **evidence** — every eligible run writes a secret-free attribution record
  (bounded identifiers, digests, enums, numbers; no prompt text, no
  credentials).
- **trigger** — one of seven closed signal classes (repeated equivalent
  failure, repeated repair, recurring HOLD, abnormal retry frequency, latency
  regression, token inefficiency, qualified pattern evidence), each with a hard
  minimum-evidence floor: a single failure can never fire a trigger.
- **candidate** — a proposed change to a declared strategy dimension, generated
  inside the policy's scope patterns.
- **fitness** — the candidate must beat the baseline under a declared
  validation plan, in an isolated worktree. The production checkout is never
  mutated during evaluation.
- **review** — an independently identified reviewer with no mutation authority.
  Self-approval is refused by construction.
- **promotion** — all gates must pass simultaneously: policy authorisation,
  fitness, regression, independent review, candidate-digest re-derivation, live
  HEAD equal to the frozen baseline, and the semantic-drift gate.
- **canary** — the promoted change runs against real work under observation.
- **accept | rollback** — accept, or roll back to the prior generation.

An operator controls this with an issued policy and a kill switch:

```bash
node scripts/evolution-operator.mjs --json              # current state (read-only)
node scripts/evolution-kill-switch.mjs --status
node scripts/evolution-kill-switch.mjs --suspend        # stop NEW evolution cycles
```

Suspension blocks new evolution cycles only. Normal operation, telemetry and
in-flight execution are unaffected — the kill switch is deliberately not a
global stop.

See [docs/autonomous-evolution.md](docs/autonomous-evolution.md).

---

## Cross-agent learning

AutoLoop can carry measured experience from one agent execution to the next:

```
Agent A / Agent B execution evidence
        ↓  (attribution feed, every eligible run)
   performance memory            (per task class × strategy dimension × value:
        ↓                         success, hold, repair, latency, tokens, sample count)
   strategy fitness
        ↓
   Agent C's effective strategy  (only if the evidence clears the floor)
```

Three properties keep this from becoming folklore:

- **Minimum evidence** — an arm needs a sample count above a floor before its
  performance may influence anything. One lucky run changes nothing.
- **Attribution** — each observation is bound to its run identity, phase,
  provider/model, task class and decomposition identity. An unattributable
  observation is not admitted.
- **Authority boundary** — the feed mints no authority. It writes advisory
  performance memory; a *separate* policy authorisation and promotion gate
  decide whether any of it changes behaviour.

Cross-agent transfer is where the feature is least mature; treat its outputs as
hypotheses, not conclusions. See
[docs/cross-agent-learning.md](docs/cross-agent-learning.md).

---

## Safety and authority

| Lever | Behaviour |
|---|---|
| Admission | deny-by-default capability set; the agent's own tool requests are ignored |
| Risk classes | LOW autonomous (policy pre-authorised) · MEDIUM operator promotion · HIGH structurally denied |
| Forbidden paths | governance, admission, evolution and `.git` are unwritable by any candidate |
| Kill switch | `--suspend` stops new evolution cycles; normal operation and telemetry continue (fail-open for the control plane, fail-closed for the loop) |
| Circuit breaker | opens on repeated candidate failure, halting the loop without operator action |
| Provider binding | explicit binding is required; a task cannot silently inherit an ambient credential or model |
| Isolation | containers run network-off, capabilities dropped, no-new-privileges, pids/memory/cpu limited; the runtime socket is never mounted into a task container |
| Evidence | every artifact is secret-scanned and size-bounded before it is written; a scanner hit is a HOLD, not a warning |

Full detail: [docs/architecture.md](docs/architecture.md) and
[docs/governance.md](docs/governance.md).

---

## Configuration

AutoLoop works with zero configuration for local exploration: all state defaults
to a single namespace (`AUTOLOOP_HOME`, default `~/.autoloop`). Point anything
elsewhere with environment variables — a configured root must be absolute, and
state may not be scattered outside the AutoLoop namespace.

```bash
AUTOLOOP_HOME=~/.autoloop              # root of all AutoLoop state
AUTOLOOP_EVIDENCE_ROOT=…               # durable evidence (default: $AUTOLOOP_HOME/evidence/autoloop)
AUTOLOOP_TELEMETRY_ROOT=…              # telemetry, must be OUTSIDE the evidence namespace
AUTOLOOP_LEARNING_ROOT=…               # transfer-metrics / incident storage
AUTOLOOP_SCRATCH_ROOT=…                # scratch for fixture work
COLIMA_HOME=…                          # Colima runtime home (machine-level container state)
AUTOLOOP_PI_RUNTIME_PATH=…             # absolute path to the `pi` CLI entry point
```

Provider credentials are read from the environment or the provider CLI's own
auth store and are never written into this repository. The complete reference —
every variable, its default, and its validation rule — is in
[docs/configuration.md](docs/configuration.md).

---

## Documentation

| Document | Contents |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | clean clone → install → configure → first real task |
| [docs/architecture.md](docs/architecture.md) | the control flow and who owns which authority |
| [docs/configuration.md](docs/configuration.md) | the full public configuration surface |
| [docs/agent-integration.md](docs/agent-integration.md) | how an agent runtime is invoked, and the adapter contract |
| [docs/durable-execution.md](docs/durable-execution.md) | checkpoints, journal, resume, and the crash-recovery model |
| [docs/governance.md](docs/governance.md) | admission, budgets, review, closeout, promotion, commit gates |
| [docs/telemetry-and-operator.md](docs/telemetry-and-operator.md) | telemetry stream, retention, operator reports |
| [docs/autonomous-evolution.md](docs/autonomous-evolution.md) | the evolution loop end to end |
| [docs/cross-agent-learning.md](docs/cross-agent-learning.md) | performance memory, fitness, transfer |
| [docs/operations.md](docs/operations.md) | running, inspecting, diagnosing, recovering |
| [docs/troubleshooting.md](docs/troubleshooting.md) | known failure modes: symptom → cause → inspection → safe action |
| [docs/benchmark.md](docs/benchmark.md) | the public effectiveness benchmark: methodology and results |
| [CONTRIBUTING.md](CONTRIBUTING.md) | development setup, tests, review and commit expectations |
| [SECURITY.md](SECURITY.md) | how to report a vulnerability |
| [AGENTS.md](AGENTS.md) | operative instructions for the agent runtime when a session's cwd is this repository |
| [docs/publication-change-inventory.md](docs/publication-change-inventory.md) | every change the open-source remediation made, and why |
| [docs/publication-triage.md](docs/publication-triage.md) | how the publication tree was triaged: what was kept, what was archived and where, and which test baselines were legitimately re-derived |

---

## Agent and provider integration

AutoLoop is provider-neutral by design. Two layers:

- An **agent runtime** executes the work. Today this is Pi
  (`@earendil-works/pi-coding-agent`), which AutoLoop drives with a pinned
  identity — its executable path and content digest are part of the admission
  contract, so a runtime swap is a visible, intentional act rather than a
  silent drift. The runtime's tool vocabulary is captured from the real binary,
  never assumed.
- A **provider** answers the model calls, reached through
  `@earendil-works/pi-ai` (the only runtime npm dependency). Providers are
  configured by name in the runtime's own configuration; AutoLoop does not
  hardcode an endpoint.

Scheduled adapters (OpenCode, Claude Code, Codex) are **not** wired in. See
[docs/agent-integration.md](docs/agent-integration.md) for the adapter
contract, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the
dependency and trademark position.

---

## Project status and limitations

Stated plainly, because a governance harness that overstates itself is
worthless:

**Not production ready.** Pre-1.0. APIs, artifact schemas and CLI surfaces can
change without a deprecation cycle. There is no release branch and no stability
promise.

**Single-operator, single-machine.** No multi-tenancy, no shared server, no
remote workers. Durability is local-filesystem durability, not distributed
consensus.

**macOS only, in practice.** The sandbox integration targets Colima's Lima VM.
Linux and Windows hosts are untested; there is no CI matrix.

**The agent runtime is an external dependency you must supply.** The host test
suite runs without it. Real execution does not.

**Sandboxed execution needs Colima and Docker.** Without them, execution falls
back to host-process isolation, which is weaker. Do not treat host-process
isolation as a security boundary.

**Review is a model verdict, not a human verdict.** The independent-review gate
is structurally independent (separate role, no mutation authority, self-approval
refused) but it is still a model judgement. It bounds blast radius; it does not
guarantee correctness.

**Evolution is EXPERIMENTAL and evidence-gated.** Its beneficiaries are
LOW-risk strategy parameters. It is not a licence for the system to rewrite
itself, and the HIGH-risk exclusion is structural rather than advisory.

**Cross-agent learning needs volume.** Minimum-evidence floors mean small
deployments will see little effect, by design.

**No blanket benchmark claim is supported.** A public pilot is published with
its raw data, including its negative results. Its decisive finding is a caution,
not a boast: two arms that are **mechanically identical** (same route, same
repair budget, same scope, same tools) scored 29/35 and 34/35 — so a ~15-point
success-rate spread exists between two runs of the *same* configuration. Read
[docs/benchmark.md](docs/benchmark.md) before quoting any number; it states the
sample sizes and separates the one mechanism that was actually identified (a
higher repair budget converts a hard `REPAIR_BUDGET_EXHAUSTED` refusal into a
retry: 5 of 35 control runs) from variance.

**Some features are exercised only by the sandbox suite**, which requires Colima
— so a CI-less clone gives you weaker evidence than the project's own runs.

---

## Support

Community, best-effort project. Issues and pull requests are welcome at
<https://github.com/xonogesrs/autoloop/issues>.

There is **no commercial support, no SLA, and no guaranteed provider
compatibility**. AutoLoop is an independent project; it is not affiliated with,
certified by, or endorsed by any agent runtime, model provider, or container
vendor whose name appears in this repository. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## License

Apache License 2.0 — see [LICENSE](LICENSE). Copyright and attribution: [NOTICE](NOTICE).
Third-party components, integrations and trademarks: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
