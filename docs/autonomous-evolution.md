# Autonomous evolution

AegisFlow can improve its own **operating strategy** — never its authority. This
document describes the loop, what each stage guarantees, and the boundaries that
make it safe to leave switched on.

## The loop

```
evidence → trigger → candidate → fitness → review → promotion → canary → accept | rollback
```

### 1. Evidence (always on)

Every eligible run writes a **secret-free attribution record** through
`src/evolution/attribution-feed.mjs`, independent of whether any trigger fires.
The record carries bounded identifiers, digests, enums and numbers only:

run identity, phase and stage identity, parent/graph relation, provider/model,
adapter, task class, decomposition identity, terminal outcome, HOLD code,
generation — plus repair, retry, latency, occupancy, fan-out counts.

No prompt text. No model response text. No credential. This is enforced by
construction (the projection copies only those fields), not by filtering.

### 2. Trigger

`src/evolution/trigger.mjs` recognises exactly seven closed signal classes:

| Signal class | Minimum evidence |
|---|---|
| `REPEATED_EQUIVALENT_FAILURE` | 3 |
| `REPEATED_REPAIR_REQUIREMENT` | 3 |
| `RECURRING_HOLD_PATTERN` | 3 |
| `ABNORMAL_RETRY_FREQUENCY` | 5 |
| `LATENCY_REGRESSION` | 3 |
| `TOKEN_INEFFICIENCY` | 3 |
| `QUALIFIED_PATTERN_EVIDENCE` | 1 (a qualified pattern already consolidates ≥2 incidents) |

A policy may only **raise** these floors, never lower them. The consequence:
**a single failure can never fire a trigger.** On top of the floor:

- an **observation window** — stale evidence never accumulates into a trigger;
- **dedup** — the same signature is suppressed;
- **cooldown** — a per-signal quiet period;
- **per-window frequency cap**;
- a **circuit breaker** in durable trigger state, which opens on repeated
  candidate failure and halts the loop without operator action.

Every trigger event pins its evidence references (journal event ids), the
observation instant, and its source.

### 3. Candidate

A candidate proposes a change to a **declared strategy dimension**. The
dimensions are:

`MODEL_ROUTING`, `DECOMPOSITION`, `CONTEXT_ALLOCATION`, `RETRY_REPAIR`,
`FANOUT_PARALLELISM`, `TOOL_SELECTION`, `PROMPT_EVOLUTION`.

A dimension is in scope only if the operator's issued policy lists it. `ABSENT`
means refused — so agent-strategy adaptation **cannot be enabled by
implication**, and an operator must re-issue a policy deliberately.

Candidate change is delivered as a patch against an isolated worktree. The
production checkout is never mutated during evaluation.

### 4. Fitness

The candidate must beat the baseline under the declared validation plan, in
isolation. Validation runs the declared commands with an explicit plan identity;
a missing or mismatched plan is a HOLD, not a default.

### 5. Review

An independently identified reviewer with **no mutation authority**. The
reviewer receives a handoff; it cannot issue authorizations. Independence is
checked: an identity that is the agent itself, or that self-identifies as the
evolution component, is refused — self-approval is structurally impossible, not
merely discouraged.

### 6. Promotion — all gates, simultaneously

| Gate | Failure code |
|---|---|
| policy pre-authorization, re-read and re-verified | `EVOLUTION_SCOPE_OUTSIDE_POLICY` |
| risk class allowed by the policy | `EVOLUTION_RISK_CLASS_REFUSED` |
| fitness PASS | fitness HOLD |
| regression PASS | regression HOLD |
| independent review PASS | review HOLD |
| candidate digest re-derivation | digest mismatch HOLD |
| live HEAD equals the frozen baseline | baseline drift HOLD |
| semantic drift gate | drift HOLD |

Any single mismatch aborts the promotion with a specific code. There is no
"mostly promoted" state.

### 7. Canary and rollback

A promoted change runs against real work under observation. Rollback restores
the prior generation, and the prior generation is archived durably
(`<store>/evolution-policy-history/`) so a rollback target always exists.

## Risk classes

| Class | Autonomy | Scope |
|---|---|---|
| **LOW** | fully autonomous within an issued policy | the six strategy dimensions, and only those the policy declares |
| **MEDIUM** | operator promotion required | `PROMPT_EVOLUTION` |
| **HIGH** | **structurally denied, never autonomous in any policy** | see below |

The HIGH-risk classes — which no policy can authorise, because the validator
requires them in `forbidden_risk_classes`:

```
SECURITY_OR_CREDENTIALS        GOVERNANCE_AUTHORITY
ADMISSION_AUTHORITY            PROMOTION_AUTHORITY
SECRET_HANDLING                DESTRUCTIVE_PERSISTENCE_MIGRATION
IRREVERSIBLE_DATA_OPERATION    EVOLUTION_POLICY_SELF
```

Plus forbidden **path patterns** that must always be present in a policy:
`src/governance/**`, `src/admission/**`, `src/evolution/**`, `.git/**`, and the
governance record root. A policy that omits them fails validation
(`forbidden_risk_classes_incomplete`).

`EVOLUTION_POLICY_SELF` deserves a sentence: the subsystem cannot mint or amend
its own policy. Policy issuance is an operator act.

## Operator controls

```bash
# Declare this deployment's evolution inputs once
node scripts/evolution-declare-production.mjs --out <path> \
  --store-root <dir> --checkpoint-root <dir> --repo-root <dir> \
  [--task-class <token>] [--strategy-baseline DIM=value ...]

# Issue a policy (operator act)
node scripts/evolution-issue-policy.mjs --store <dir>
node scripts/evolution-issue-policy.mjs --store <dir> --successor [--previous-digest <64hex>]

# Inspect (read-only, zero writes)
node scripts/evolution-operator.mjs [--store <dir>] [--json]

# Kill switch
node scripts/evolution-kill-switch.mjs --store <dir> --status
node scripts/evolution-kill-switch.mjs --store <dir> --suspend
node scripts/evolution-kill-switch.mjs --store <dir> --resume
```

The declaration is read through `AEGISFLOW_EVOLUTION_DEPLOYMENT_CONFIG`. Without
a resolvable declaration, evolution refuses to run.

### What the kill switch does and does not do

`AUTO_EVOLUTION = ENABLED | SUSPENDED`.

- **SUSPENDED blocks new evolution cycles only.**
- Normal operation, telemetry, and in-flight execution are **untouched**.

This is deliberate. A kill switch that stopped the control plane would be a
denial-of-service lever; the thing being halted is the loop that proposes
changes, not the machinery that runs work.

## What the operator view shows

- the issued policy, its generation, and its history;
- circuit-breaker state;
- triggers, candidates, reviews, canary state, rollbacks;
- the active strategy policy;
- the strategy performance memory;
- the every-run attribution feed and any feed failures;
- the resolved production declaration.

## Honest limitations

- **LOW-risk only.** The dimension set is genuinely narrow.
- **Needs volume.** Minimum-evidence floors mean a small deployment will rarely
  fire a trigger. That is the intent: the alternative is acting on noise.
- **Fitness is a proxy.** A candidate that wins on the declared plan may still
  lose in a dimension the plan does not measure.
- **Canary is not a guarantee.** It is observation, and rollback is the
  backstop.
- **EXPERIMENTAL.** Interfaces may change; the safety structure is what is
  stable.

## Cross-agent learning

Strategy transfer across agents is a separate concern — see
[cross-agent-learning.md](cross-agent-learning.md).
